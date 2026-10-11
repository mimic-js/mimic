module.exports = function receiptLoader(source) {
  return source.replace('SOURCE_MARKER', 'LOADER_APPLIED');
};
