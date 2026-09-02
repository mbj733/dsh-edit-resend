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
  },
  clientConfig,
]
