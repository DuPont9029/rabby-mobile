//! Manual end-to-end check: `cargo run --release --example e2e -- <data_dir>`.
use std::time::{Duration, Instant};

fn main() {
    let data_dir = std::env::args().nth(1).expect("data dir");
    let started = Instant::now();
    rabby_helios_node::start(rabby_helios_node::StartConfig {
        execution_rpcs: std::env::var("EXEC").unwrap_or("https://ethereum-rpc.publicnode.com".into()).split(',').map(String::from).collect(),
        consensus_rpcs: vec!["https://ethereum-beacon-api.publicnode.com".into()],
        data_dir,
    });
    loop {
        let status = rabby_helios_node::status_json();
        if !status.contains("syncing") {
            println!("status {status} after {:?}", started.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    for _ in 0..3 {
        let answer = rabby_helios_node::request(r#"{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x8539D33A42cf1f2ACDD72DEBD3e31A75C9F136C6","data":"0xc87b56ddc81b0fb815c858b7d2b66a1a2371c7bfef3f5e86539477fde5def29eff454836"},"latest"]}"#);
        println!("eth_call -> {} chars: {}", answer.len(), &answer[..answer.len().min(120)]);
        if answer.contains("\"result\"") { break; }
    }
}
