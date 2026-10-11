class ClaimPlugin {
  apply(compiler) {
    compiler.hooks.emit.tap('ClaimPlugin', (compilation) => {
      compilation.assets['claim-plugin.txt'] = { source: () => 'PLUGIN_APPLIED', size: () => 14 };
    });
    compiler.hooks.done.tap('ClaimPlugin', (stats) => console.log('WEBPACK_CLAIM_PLUGIN ' + stats.hash));
  }
}
module.exports = ClaimPlugin;
