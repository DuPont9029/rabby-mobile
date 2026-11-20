#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Starts the in-process Helios light client (Ethereum mainnet).
// config_json: {"executionRpcs":[...],"consensusRpcs":[...],"dataDir":"..."}
// Returns 0 when accepted; poll rabby_helios_status() for progress.
int32_t rabby_helios_start(const char* config_json);
void rabby_helios_stop(void);
// {"state":"stopped|syncing|synced|failed","error":null|"..."}
char* rabby_helios_status(void);
// Runs one JSON-RPC request (blocking) and returns the JSON-RPC response.
char* rabby_helios_request(const char* request_json);
void rabby_helios_free_string(char* value);

#ifdef __cplusplus
}
#endif
