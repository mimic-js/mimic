const path = require('node:path');
const ReceiptPlugin = require('./receipt-plugin.js');
module.exports = {
  mode: 'development',
  target: 'web',
  entry: './src/index.js',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js' },
  module: { rules: [{ test: /\.js$/, use: path.resolve(__dirname, 'receipt-loader.js') }] },
  plugins: [new ReceiptPlugin()],
  watchOptions: { aggregateTimeout: 10, poll: 50 },
  devServer: { host: '127.0.0.1', port: 5173, hot: true, hotOnly: true, contentBase: path.resolve(__dirname, 'public'), historyApiFallback: true, writeToDisk: true }
};
