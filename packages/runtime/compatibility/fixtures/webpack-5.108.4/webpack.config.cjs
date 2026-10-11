const path = require('node:path');
const ClaimPlugin = require('./claim-plugin.js');
module.exports = {
  mode: 'development',
  target: 'web',
  entry: './src/index.js',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js' },
  module: { rules: [{ test: /\.js$/, use: path.resolve(__dirname, 'claim-loader.js') }] },
  plugins: [new ClaimPlugin()],
  watchOptions: { aggregateTimeout: 10 },
  devServer: { host: '127.0.0.1', port: 5173, hot: true, liveReload: false, static: { directory: path.resolve(__dirname, 'public') }, historyApiFallback: true, devMiddleware: { writeToDisk: true } }
};
