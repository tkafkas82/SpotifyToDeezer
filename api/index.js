/*
 * Serverless entry point.
 *
 * Vercel turns each file under /api into a function and hands it the request, so
 * the whole app is one function: an Express app is already a (req, res) handler,
 * and vercel.json routes every /api/* path here. The static page itself is served
 * straight off the CDN out of public/, so it never wakes this up.
 *
 * server.js does not call listen() when VERCEL is set - see the bottom of it.
 */
export { default } from '../server.js';
