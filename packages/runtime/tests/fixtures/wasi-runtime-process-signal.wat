(module
  (import "wasi_snapshot_preview1" "sched_yield"
    (func $sched_yield (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $forever
      (drop (call $sched_yield))
      (br $forever)))
)
