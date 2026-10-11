class ReceiptPlugin {
  apply(compiler) {
    compiler.hooks.emit.tap('ReceiptPlugin', (compilation) => {
      compilation.assets['plugin-receipt.txt'] = { source: () => 'PLUGIN_APPLIED', size: () => 14 };
    });
    compiler.hooks.done.tap('ReceiptPlugin', (stats) => console.log(`RECEIPT_PLUGIN_CHILD_OUTPUT ${stats.hash}`));
  }
}
module.exports = ReceiptPlugin;
