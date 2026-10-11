import { EventEmitter } from './events';

/** `node:v8`: serialization through JSON envelopes and empty heap statistics. */
export function createV8Builtin(): unknown {
  const typeKey = '__mimicV8Type';
  const serialize = (value: unknown) => {
    const envelopes = new WeakSet<object>();
    const envelope = (type: string, fields: Record<string, unknown>) => {
      const result = { [typeKey]: type, ...fields };
      envelopes.add(result);
      return result;
    };
    return new TextEncoder().encode(
      JSON.stringify(value, (_key, nestedValue) => {
        if (nestedValue !== null && typeof nestedValue === 'object' && envelopes.has(nestedValue)) return nestedValue;
        if (nestedValue instanceof Map) return envelope('Map', { mapEntries: [...nestedValue] });
        if (nestedValue instanceof Set) return envelope('Set', { values: [...nestedValue] });
        if (nestedValue instanceof Uint8Array) return envelope('Uint8Array', { values: [...nestedValue] });
        if (typeof nestedValue === 'bigint') return envelope('BigInt', { value: nestedValue.toString() });
        if (nestedValue !== null && typeof nestedValue === 'object' && Object.hasOwn(nestedValue, typeKey)) {
          return envelope('EscapedObject', { objectEntries: Object.entries(nestedValue) });
        }
        return nestedValue;
      })
    );
  };
  const deserialize = (buffer: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(buffer), (_key, nestedValue) => {
      if (!nestedValue || typeof nestedValue !== 'object' || !(typeKey in nestedValue)) return nestedValue;
      const tagged = nestedValue as {
        [typeKey]: string;
        mapEntries?: [unknown, unknown][];
        objectEntries?: [string, unknown][];
        values?: unknown[];
        value?: string;
      };
      if (tagged[typeKey] === 'Map') return new Map(tagged.mapEntries ?? []);
      if (tagged[typeKey] === 'Set') return new Set(tagged.values ?? []);
      if (tagged[typeKey] === 'Uint8Array') return new Uint8Array((tagged.values ?? []) as number[]);
      if (tagged[typeKey] === 'BigInt') return BigInt(tagged.value ?? '0');
      if (tagged[typeKey] === 'EscapedObject') return Object.fromEntries(tagged.objectEntries ?? []);
      return nestedValue;
    });
  const v8 = {
    cachedDataVersionTag: () => 0,
    getHeapCodeStatistics: () => ({
      code_and_metadata_size: 0,
      bytecode_and_metadata_size: 0,
      external_script_source_size: 0,
      cpu_profiler_metadata_size: 0
    }),
    getHeapSpaceStatistics: () => [],
    getHeapSnapshot: () => {
      const stream = new EventEmitter();
      queueMicrotask(() => {
        stream.emit('data', '{}');
        stream.emit('end');
      });
      return stream;
    },
    getHeapStatistics: () => ({
      total_heap_size: 0,
      total_heap_size_executable: 0,
      total_physical_size: 0,
      total_available_size: Number.MAX_SAFE_INTEGER,
      used_heap_size: 0,
      heap_size_limit: Number.MAX_SAFE_INTEGER,
      malloced_memory: 0,
      peak_malloced_memory: 0,
      does_zap_garbage: 0,
      number_of_native_contexts: 1,
      number_of_detached_contexts: 0,
      total_global_handles_size: 0,
      used_global_handles_size: 0,
      external_memory: 0
    }),
    serialize,
    deserialize,
    writeHeapSnapshot: () => {
      throw Object.assign(new Error('v8.writeHeapSnapshot is not supported in Mimic yet'), { code: 'ENOTSUP' });
    },
    setFlagsFromString: () => undefined,
    startupSnapshot: {
      isBuildingSnapshot: () => false,
      addSerializeCallback: () => undefined,
      addDeserializeCallback: () => undefined,
      setDeserializeMainFunction: () => undefined
    }
  };
  return {
    ...v8,
    default: v8
  };
}
