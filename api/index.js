// Vercel entry point. The same Express app, handed over as a serverless
// function; vercel.json rewrites every path here.
import 'dotenv/config';
import { app } from '../src/app.js';
export default app;
