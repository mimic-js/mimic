export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function notFound(request, _response, next) {
  next(new HttpError(404, `no route for ${request.method} ${request.path}`));
}

// Express recognises an error handler by its four parameters.
export function errorHandler(error, _request, response, _next) {
  const status = error.status ?? error.statusCode ?? 500;
  if (status >= 500) console.error(error);
  response.status(status).json({ error: error.message });
}
