(module
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    ;; One relative monotonic-clock subscription with a 60-second timeout.
    ;; Runtime teardown must terminate the blocked WASI Execution worker.
    i32.const 16
    i32.const 1
    i32.store
    i32.const 24
    i64.const 60000000000
    i64.store
    i32.const 0
    i32.const 64
    i32.const 1
    i32.const 128
    call $poll_oneoff
    drop))
