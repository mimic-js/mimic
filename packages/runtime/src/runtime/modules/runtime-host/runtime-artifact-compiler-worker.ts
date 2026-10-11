/// <reference lib="webworker" />

import * as Babel from './runtime-artifact-compiler-babel';

import {
  createRuntimeArtifactTranslator,
  runtimeArtifactCompileFailure
} from '../module-execution-engine';
import { connectRpc } from '../worker-transport';
import type { RuntimeArtifactCompilerWorkerApi } from './runtime-artifact-compiler-pool';

// One worker of the compiler pool. Babel lives here only (ADR-0034): process workers
// receive compiled text and never load a compiler.
const translate = createRuntimeArtifactTranslator(Babel);

connectRpc(self as DedicatedWorkerGlobalScope, {
  translate(kind, source) {
    try {
      return { status: 'compiled', ...translate(kind, source) };
    } catch (error) {
      return { status: 'failed', error: runtimeArtifactCompileFailure(error) };
    }
  }
} satisfies RuntimeArtifactCompilerWorkerApi);
