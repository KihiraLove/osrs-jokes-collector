import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { JokeRepository } from '../db/repository.ts';
import { ValidationError } from '../domain.ts';
import type { JokeInput } from '../domain.ts';
import { normalizeJoke, normalizeName, normalizeThemes } from '../normalization.ts';
import { emptyDraft, renderHome } from '../views/home.ts';
import type { SubmissionDraft } from '../views/home.ts';
import type { SubmissionLimiter } from './limiter.ts';

// Includes percent-encoding overhead for two 4,000-code-point parts and themes.
export const SUBMISSION_BODY_LIMIT = 128 * 1024;

export interface SubmissionOptions {
  repository: Pick<JokeRepository, 'listThemes' | 'submit'>;
  limiter: Pick<SubmissionLimiter, 'take'>;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function draftFrom(body: Record<string, unknown>): SubmissionDraft {
  return {
    kind: body.kind === 'two_part' ? 'two_part' : 'single',
    text: typeof body.text === 'string' ? body.text : '',
    punchline: typeof body.punchline === 'string' ? body.punchline : '',
    themes: typeof body.themes === 'string' ? [body.themes] : Array.isArray(body.themes) ? body.themes.filter((value): value is string => typeof value === 'string') : [],
    newThemes: typeof body.newThemes === 'string' ? body.newThemes : '',
  };
}

function submissionInput(body: Record<string, unknown>, draft: SubmissionDraft): JokeInput {
  if (body.kind !== 'single' && body.kind !== 'two_part') throw new ValidationError('Choose Single joke or Two part joke.');
  if (typeof body.text !== 'string' || (body.kind === 'two_part' && typeof body.punchline !== 'string')) {
    throw new ValidationError('Enter the joke text and, for a two part joke, its punchline.');
  }
  if ((body.themes !== undefined && typeof body.themes !== 'string' && (!Array.isArray(body.themes) || !body.themes.every(value => typeof value === 'string')))
    || (body.newThemes !== undefined && typeof body.newThemes !== 'string')) {
    throw new ValidationError('Choose theme names or enter new themes one per line.');
  }
  const names = [...draft.themes, ...draft.newThemes.split(/\r?\n/u).filter(name => /[^\p{White_Space}\uFEFF]/u.test(name))];
  const unique = new Map(names.map(name => { const value = normalizeName(name, 80); return [value.key, value.name]; }));
  const themes = normalizeThemes([...unique.values()]).map(theme => theme.name);
  const input: JokeInput = { kind: body.kind, text: body.text, punchline: body.kind === 'two_part' ? draft.punchline : null, themes };
  normalizeJoke(input);
  return input;
}

export function registerSubmissions(app: FastifyInstance, options?: SubmissionOptions): void {
  app.register(async publicApp => {
    await publicApp.register(formbody);
    const themes = () => options?.repository.listThemes() ?? Promise.resolve([]);
    publicApp.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
      reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    });
    publicApp.setErrorHandler(async (error, request, reply) => {
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
      if (code === 500) request.log.error('Public submission request failed.');
      const message = code === 413 ? 'This request is too large. Use up to 4,000 characters per joke part and 10 themes of up to 80 characters.'
        : code < 500 ? 'The form could not be read. Check your entries and try again.' : 'The form is temporarily unavailable. Please try again shortly.';
      return reply.code(code).type('text/html').send(renderHome([], draftFrom(bodyRecord(request.body)), message));
    });
    publicApp.get<{ Querystring: { submitted?: string } }>('/', async (request, reply) => {
      return reply.type('text/html').send(renderHome(await themes(), emptyDraft(), '', request.query.submitted === '1'));
    });
    publicApp.post('/', { bodyLimit: SUBMISSION_BODY_LIMIT }, async (request, reply) => {
      const body = bodyRecord(request.body);
      const draft = draftFrom(body);
      const showError = async (code: number, message: string) => reply.code(code).type('text/html').send(renderHome(await themes(), draft, message));
      if (body.intent === 'preview') return reply.type('text/html').send(renderHome(await themes(), draft));
      if (!options) return showError(503, 'Submissions are temporarily unavailable. Please try again shortly.');
      const retry = await options.limiter.take(request.ip);
      if (retry !== null) {
        reply.header('Retry-After', retry);
        return showError(429, `Too many submission attempts. Please wait ${retry} seconds and try again. Your draft is below.`);
      }
      try {
        const input = submissionInput(body, draft);
        await options.repository.submit(input);
      } catch (error) {
        if (error instanceof ValidationError) return showError(422, error.message);
        request.log.error('Joke submission failed.');
        return showError(503, 'Your joke could not be saved. Your draft is below; please try again shortly.');
      }
      return reply.code(303).header('Location', '/?submitted=1').send();
    });
  });
}
