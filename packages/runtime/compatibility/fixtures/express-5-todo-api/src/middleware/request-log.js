export function requestLog(request, response, next) {
  const startedAt = performance.now();
  response.on('finish', () => {
    const elapsed = (performance.now() - startedAt).toFixed(1);
    console.log(`${request.method} ${request.originalUrl} ${response.statusCode} ${elapsed}ms`);
  });
  next();
}
