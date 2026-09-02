import { clientBundle } from './scripts/dsh-client-preset.ts'

const PLUGIN_ID = 'dsh-edit-resend'
const clientConfig = clientBundle(PLUGIN_ID)

export default () => [
  {
    entry: { index: 'src/host.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Host half must stay thin: @deepseek-ai/* resolve at DSH runtime via the
    // node_modules junctions into the harness checkout (link-types.mjs).
    // Bundling them inlines e.g. dsh-llm's createRequire('../package.json'),
    // which then points outside the plugin root and crashes dsh web at boot.
    external: [/^@deepseek-ai\//],
  },
  clientConfig,
]
