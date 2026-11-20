//! In-process a16z Helios light client for Ethereum mainnet.
//!
//! Helios follows the beacon chain with the sync-committee light-client
//! protocol and verifies every execution answer (balances, `eth_call`, code,
//! ...) against the verified state root with Merkle proofs, so the execution
//! RPC only supplies data and cannot lie about it.
//!
//! The app talks to it through a C ABI with JSON-RPC strings. There is no
//! network server: other apps on the device cannot reach it.
//!
//! Trust root: the first sync starts from a finalized checkpoint that at
//! least [`CHECKPOINT_QUORUM`] independent operators agree on. Helios then
//! stores newer checkpoints in its data directory and later starts reuse it.

use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    str::FromStr,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use alloy::primitives::B256;
use helios_ethereum::{
    config::networks::Network, database::FileDB, EthereumClient, EthereumClientBuilder,
};
use serde::Deserialize;

/// Distinct operators that must report the same finalized root.
pub const CHECKPOINT_QUORUM: usize = 3;
const SYNC_TIMEOUT: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CHECKPOINT_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// (operator, beacon/checkpoint-sync base URL). One vote per operator.
const CHECKPOINT_SOURCES: &[(&str, &str)] = &[
    ("allnodes", "https://ethereum-beacon-api.publicnode.com"),
    ("chainsafe", "https://beaconstate-mainnet.chainsafe.io"),
    ("chainsafe", "https://lodestar-mainnet.chainsafe.io"),
    ("ethstaker", "https://beaconstate.ethstaker.cc"),
    ("sigmaprime", "https://mainnet.checkpoint.sigp.io"),
    ("pietjepuk", "https://checkpointz.pietjepuk.net"),
    ("beaconcha.in", "https://sync-mainnet.beaconcha.in"),
    ("attestant", "https://mainnet-checkpoint-sync.attestant.io"),
];

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartConfig {
    /// Tried in order; the node moves to the next one when an RPC keeps
    /// failing (e.g. a load-balanced backend without recent proofs).
    pub execution_rpcs: Vec<String>,
    pub consensus_rpcs: Vec<String>,
    pub data_dir: String,
}

#[derive(Clone)]
enum Phase {
    Stopped,
    Syncing,
    Synced,
    Failed(String),
}

struct Node {
    config: Option<StartConfig>,
    phase: Phase,
    client: Option<EthereumClient>,
    methods: Option<helios_core::jsonrpc::MethodsHandle>,
    generation: u64,
    execution_index: usize,
    upstream_failures: u32,
}

static NODE: Mutex<Node> = Mutex::new(Node {
    config: None,
    phase: Phase::Stopped,
    client: None,
    methods: None,
    generation: 0,
    execution_index: 0,
    upstream_failures: 0,
});
/// Consecutive requests failing upstream before switching execution RPC.
const UPSTREAM_FAILURES_BEFORE_SWITCH: u32 = 2;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("helios")
            .enable_all()
            .build()
            .expect("helios runtime")
    })
}

fn lock() -> std::sync::MutexGuard<'static, Node> {
    NODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn checkpoint_http() -> alloy::transports::http::reqwest::Client {
    use alloy::transports::http::reqwest;
    reqwest::Client::builder()
        .tls_certs_only(helios_core::execution::providers::rpc::mozilla_root_certs())
        .timeout(CHECKPOINT_FETCH_TIMEOUT)
        .build()
        .expect("checkpoint HTTP client")
}

/// Picks the finalized root reported by the most distinct operators, if at
/// least `quorum` agree. Pure, for tests.
pub fn pick_quorum_root(votes: &[(String, B256)], quorum: usize) -> Option<B256> {
    let mut by_root: HashMap<B256, Vec<&str>> = HashMap::new();
    for (operator, root) in votes {
        let operators = by_root.entry(*root).or_default();
        if !operators.contains(&operator.as_str()) {
            operators.push(operator);
        }
    }
    let mut best: Option<(B256, usize)> = None;
    let mut tie = false;
    for (root, operators) in by_root {
        let count = operators.len();
        match best {
            Some((_, best_count)) if count < best_count => {}
            Some((_, best_count)) if count == best_count => tie = true,
            _ => {
                best = Some((root, count));
                tie = false;
            }
        }
    }
    match best {
        Some((root, count)) if count >= quorum && !tie => Some(root),
        _ => None,
    }
}

fn parse_root(body: &serde_json::Value) -> Option<B256> {
    let raw = body.get("data")?.get("root")?.as_str()?;
    let hex = raw.strip_prefix("0x").unwrap_or(raw);
    if hex.len() != 64 {
        return None;
    }
    B256::from_str(hex).ok()
}

async fn quorum_checkpoint() -> Result<B256, String> {
    let http = checkpoint_http();
    let requests = CHECKPOINT_SOURCES.iter().map(|(operator, base)| {
        let http = http.clone();
        async move {
            let url = format!("{base}/eth/v1/beacon/blocks/finalized/root");
            let body: serde_json::Value = http.get(url).send().await.ok()?.json().await.ok()?;
            parse_root(&body).map(|root| (operator.to_string(), root))
        }
    });
    let votes: Vec<(String, B256)> = futures::future::join_all(requests)
        .await
        .into_iter()
        .flatten()
        .collect();
    pick_quorum_root(&votes, CHECKPOINT_QUORUM).ok_or_else(|| {
        format!(
            "no checkpoint quorum ({} answers, need {CHECKPOINT_QUORUM} agreeing operators)",
            votes.len()
        )
    })
}

fn has_stored_checkpoint(data_dir: &str) -> bool {
    std::fs::metadata(PathBuf::from(data_dir).join("checkpoint"))
        .map(|meta| meta.len() == 32)
        .unwrap_or(false)
}

async fn build_and_sync(
    config: &StartConfig,
    execution_rpc: &str,
    consensus_rpc: &str,
    checkpoint: Option<B256>,
) -> Result<EthereumClient, String> {
    let mut builder = EthereumClientBuilder::<FileDB>::new()
        .network(Network::Mainnet)
        .consensus_rpc(consensus_rpc)
        .map_err(|e| e.to_string())?
        .execution_rpc(execution_rpc)
        .map_err(|e| e.to_string())?
        .data_dir(PathBuf::from(&config.data_dir))
        .with_file_db();
    if let Some(checkpoint) = checkpoint {
        builder = builder.checkpoint(checkpoint);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    match tokio::time::timeout(SYNC_TIMEOUT, client.wait_synced()).await {
        Ok(Ok(())) => Ok(client),
        Ok(Err(e)) => {
            client.shutdown().await;
            Err(e.to_string())
        }
        Err(_) => {
            client.shutdown().await;
            Err("sync timed out".into())
        }
    }
}

async fn start_node(config: StartConfig, execution_rpc: String) -> Result<EthereumClient, String> {
    std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
    let mut last_error = String::from("no consensus RPC configured");
    for consensus_rpc in &config.consensus_rpcs {
        // Stored checkpoint first (kept fresh by Helios itself), then a new
        // quorum checkpoint if that one is missing or too old.
        if has_stored_checkpoint(&config.data_dir) {
            match build_and_sync(&config, &execution_rpc, consensus_rpc, None).await {
                Ok(client) => return Ok(client),
                Err(e) => last_error = e,
            }
        }
        let checkpoint = quorum_checkpoint().await?;
        match build_and_sync(&config, &execution_rpc, consensus_rpc, Some(checkpoint)).await {
            Ok(client) => return Ok(client),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// Starts (or keeps) the node. Returns immediately; poll [`status_json`].
pub fn start(config: StartConfig) {
    let mut node = lock();
    let same = node.config.as_ref() == Some(&config);
    if same && matches!(node.phase, Phase::Syncing | Phase::Synced) {
        return;
    }
    node.config = Some(config);
    node.execution_index = 0;
    launch(&mut node);
}

/// (Re)starts the node with the current config and execution RPC.
fn launch(node: &mut Node) {
    let Some(config) = node.config.clone() else { return };
    let Some(execution_rpc) = config.execution_rpcs.get(node.execution_index).cloned() else {
        node.phase = Phase::Failed("no execution RPC configured".into());
        return;
    };
    if let Some(old) = node.client.take() {
        runtime().spawn(async move { old.shutdown().await });
    }
    node.methods = None;
    node.phase = Phase::Syncing;
    node.upstream_failures = 0;
    node.generation += 1;
    let generation = node.generation;
    runtime().spawn(async move {
        let result = start_node(config, execution_rpc).await;
        let mut node = lock();
        if node.generation != generation {
            if let Ok(client) = result {
                runtime().spawn(async move { client.shutdown().await });
            }
            return;
        }
        match result.and_then(|client| {
            let methods = helios_core::jsonrpc::methods_handle((*client).clone())
                .map_err(|e| e.to_string())?;
            Ok((client, methods))
        }) {
            Ok((client, methods)) => {
                node.client = Some(client);
                node.methods = Some(methods);
                node.phase = Phase::Synced;
            }
            Err(e) => {
                // Try the next execution RPC before giving up.
                let count = node.config.as_ref().map_or(0, |c| c.execution_rpcs.len());
                if node.execution_index + 1 < count {
                    node.execution_index += 1;
                    launch(&mut node);
                } else {
                    node.phase = Phase::Failed(e);
                }
            }
        }
    });
}

pub fn stop() {
    let mut node = lock();
    node.generation += 1;
    node.methods = None;
    node.config = None;
    node.phase = Phase::Stopped;
    if let Some(old) = node.client.take() {
        runtime().spawn(async move { old.shutdown().await });
    }
}

pub fn status_json() -> String {
    let node = lock();
    let (state, error) = match &node.phase {
        Phase::Stopped => ("stopped", None),
        Phase::Syncing => ("syncing", None),
        Phase::Synced => ("synced", None),
        Phase::Failed(e) => ("failed", Some(e.clone())),
    };
    serde_json::json!({ "state": state, "error": error }).to_string()
}

fn rpc_error(request: &str, code: i64, message: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// True when the answer failed because of the execution RPC (not because
/// the request itself is invalid or reverts).
pub fn is_upstream_failure(response: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(response) else {
        return true;
    };
    let Some(message) = value.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str())
    else {
        return false;
    };
    ["server returned an error response", "error sending request", "deserialization error", "timed out"]
        .iter()
        .any(|needle| message.contains(needle))
}

/// Runs one JSON-RPC request against the verified node. Blocks the caller.
pub fn request(request: &str) -> String {
    let (methods, generation) = {
        let node = lock();
        match (&node.phase, &node.methods) {
            (Phase::Synced, Some(methods)) => (methods.clone(), node.generation),
            _ => return rpc_error(request, -32001, "helios not synced"),
        }
    };
    let owned = request.to_owned();
    let response = runtime().block_on(async move {
        let mut last = String::new();
        // One retry: load-balanced RPCs often answer from another backend.
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            last = match tokio::time::timeout(REQUEST_TIMEOUT, methods.call(&owned)).await {
                Ok(Ok(response)) => response,
                Ok(Err(e)) => rpc_error(&owned, -32603, &e),
                Err(_) => rpc_error(&owned, -32002, "helios request timed out"),
            };
            if !is_upstream_failure(&last) {
                break;
            }
        }
        last
    });
    let mut node = lock();
    if node.generation == generation {
        if is_upstream_failure(&response) {
            node.upstream_failures += 1;
            let count = node.config.as_ref().map_or(0, |c| c.execution_rpcs.len());
            if node.upstream_failures >= UPSTREAM_FAILURES_BEFORE_SWITCH && count > 1 {
                node.execution_index = (node.execution_index + 1) % count;
                launch(&mut node);
            }
        } else {
            node.upstream_failures = 0;
        }
    }
    response
}

// ---- C ABI ---------------------------------------------------------------

fn into_c_string(value: String) -> *mut c_char {
    CString::new(value.replace('\0', ""))
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

unsafe fn from_c_str<'a>(value: *const c_char) -> Option<&'a str> {
    if value.is_null() {
        return None;
    }
    CStr::from_ptr(value).to_str().ok()
}

/// # Safety
/// `config_json` must be a NUL-terminated UTF-8 string. Returns 0 on success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rabby_helios_start(config_json: *const c_char) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(text) = from_c_str(config_json) else { return 1 };
        match serde_json::from_str::<StartConfig>(text) {
            Ok(config)
                if !config.execution_rpcs.is_empty()
                    && !config.consensus_rpcs.is_empty()
                    && !config.data_dir.is_empty() =>
            {
                start(config);
                0
            }
            _ => 2,
        }
    }))
    .unwrap_or(3)
}

#[unsafe(no_mangle)]
pub extern "C" fn rabby_helios_stop() {
    let _ = catch_unwind(stop);
}

/// Returns a JSON status string; free it with [`rabby_helios_free_string`].
#[unsafe(no_mangle)]
pub extern "C" fn rabby_helios_status() -> *mut c_char {
    into_c_string(catch_unwind(status_json).unwrap_or_else(|_| "{\"state\":\"failed\",\"error\":\"panic\"}".into()))
}

/// # Safety
/// `request_json` must be a NUL-terminated UTF-8 string. Blocks until the
/// answer is ready. Free the result with [`rabby_helios_free_string`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rabby_helios_request(request_json: *const c_char) -> *mut c_char {
    let response = catch_unwind(AssertUnwindSafe(|| match from_c_str(request_json) {
        Some(text) => request(text),
        None => rpc_error("null", -32700, "invalid request string"),
    }))
    .unwrap_or_else(|_| rpc_error("null", -32603, "helios panic"));
    into_c_string(response)
}

/// # Safety
/// `value` must come from this library (or be null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rabby_helios_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(byte: u8) -> B256 {
        B256::repeat_byte(byte)
    }

    #[test]
    fn quorum_needs_distinct_operators() {
        let votes = vec![
            ("chainsafe".to_string(), root(1)),
            ("chainsafe".to_string(), root(1)),
            ("sigmaprime".to_string(), root(1)),
        ];
        assert_eq!(pick_quorum_root(&votes, 3), None);
    }

    #[test]
    fn quorum_picks_the_majority_root() {
        let votes = vec![
            ("a".to_string(), root(1)),
            ("b".to_string(), root(1)),
            ("c".to_string(), root(1)),
            ("d".to_string(), root(2)),
            ("e".to_string(), root(2)),
        ];
        assert_eq!(pick_quorum_root(&votes, 3), Some(root(1)));
    }

    #[test]
    fn quorum_rejects_a_tie() {
        let votes = vec![
            ("a".to_string(), root(1)),
            ("b".to_string(), root(1)),
            ("c".to_string(), root(1)),
            ("d".to_string(), root(2)),
            ("e".to_string(), root(2)),
            ("f".to_string(), root(2)),
        ];
        assert_eq!(pick_quorum_root(&votes, 3), None);
    }

    #[test]
    fn parses_roots_with_or_without_prefix() {
        let hex = "98a6aeb7a231ec1e2ebf8fe2c0d4149539b843265c7486d592eb238f4662779c";
        for raw in [hex.to_string(), format!("0x{hex}")] {
            let body = serde_json::json!({ "data": { "root": raw } });
            assert_eq!(parse_root(&body), Some(B256::from_str(hex).unwrap()));
        }
        assert_eq!(parse_root(&serde_json::json!({ "data": { "root": "0x12" } })), None);
    }

    #[test]
    fn classifies_upstream_failures() {
        let upstream = r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"evm error: \"server returned an error response: error code 4444: distance to target block exceeds maximum proof window\""}}"#;
        let revert = r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#;
        let ok = r#"{"jsonrpc":"2.0","id":1,"result":"0x01"}"#;
        assert!(is_upstream_failure(upstream));
        assert!(!is_upstream_failure(revert));
        assert!(!is_upstream_failure(ok));
    }

    #[test]
    fn requests_fail_cleanly_before_sync() {
        let answer: serde_json::Value = serde_json::from_str(&request(
            r#"{"jsonrpc":"2.0","id":7,"method":"eth_blockNumber","params":[]}"#,
        ))
        .unwrap();
        assert_eq!(answer["id"], 7);
        assert_eq!(answer["error"]["code"], -32001);
    }
}
