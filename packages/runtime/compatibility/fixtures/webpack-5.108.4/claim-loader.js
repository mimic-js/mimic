module.exports = function claimLoader(source) {
  return source.replace('SOURCE_MARKER', 'LOADER_APPLIED');
};
