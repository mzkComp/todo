// Errors with an HTTP status code. Operations in core throw these on bad input, and the server responds with that code (an
// error without a code counts as 500)
export const fail = (code, msg) => Object.assign(new Error(msg), { code });
/** Bad input: 400 */
export const invalid = (msg) => fail(400, msg);
/** Not found: 404 */
export const notFound = (msg) => fail(404, msg);
