import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JokeRepository } from '../db/repository.ts';
import { ConflictError, ValidationError } from '../domain.ts';
import { parseThemeInput, readThemeDraft } from '../theme-input.ts';
import { renderJokeDeletion, renderJokes, renderModerationNotice, renderThemeDeletion, renderThemeEditor, renderThemes } from '../views/moderation.ts';
import { listingFilter, listingUrl, PAGE_SIZE, readListing, record, UUID } from './listing.ts';
import { csrfTokenForSession } from './store.ts';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const csrf = (request: FastifyRequest) => csrfTokenForSession(request.adminToken!);

function resourceId(request: FastifyRequest): string {
  const id = record(request.params).id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new ValidationError('This record link is invalid.');
  return id;
}

function notice(value: unknown): string {
  if (value === 'joke-deleted') return 'The joke was deleted. Its deck and themes were preserved.';
  if (value === 'themes-saved') return 'The joke’s themes were saved.';
  if (value === 'theme-deleted') return 'The theme and its associations were deleted. Jokes and deck assignments were preserved.';
  return '';
}

// Called only inside registerAdmin's authenticated, CSRF-protected scope.
export function registerModeration(admin: FastifyInstance, repository: JokeRepository): void {
  const send = (reply: FastifyReply, html: string, status = 200) => reply.code(status).type('text/html').send(html);
  const missingJoke = (request: FastifyRequest, reply: FastifyReply) => send(reply, renderModerationNotice(csrf(request), 'This joke no longer exists. Return to the listing to see current submissions.'), 404);
  const missingTheme = (request: FastifyRequest, reply: FastifyReply) => send(reply, renderModerationNotice(csrf(request), 'This theme no longer exists. Choose another theme or All themes.'), 404);
  const guard = (handler: Handler): Handler => async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof ValidationError) return send(reply, renderModerationNotice(csrf(request), error.message), 400);
      throw error;
    }
  };

  admin.get('/jokes', guard(async (request, reply) => {
    const state = readListing(request.query);
    const themes = await repository.listThemeUsage();
    if (state.theme !== 'all' && state.theme !== 'none' && !themes.some(theme => theme.id === state.theme.toLowerCase())) return missingTheme(request, reply);
    const results = await repository.list(listingFilter(state));
    return send(reply, renderJokes(csrf(request), results.slice(0, PAGE_SIZE), themes, state, results.length > PAGE_SIZE, notice(record(request.query).notice)));
  }));

  admin.get('/themes', guard(async (request, reply) => {
    return send(reply, renderThemes(csrf(request), await repository.listThemeUsage(), notice(record(request.query).notice)));
  }));

  admin.get('/jokes/:id/themes', guard(async (request, reply) => {
    const state = readListing(request.query);
    const joke = await repository.getJoke(resourceId(request));
    if (!joke) return missingJoke(request, reply);
    return send(reply, renderThemeEditor(csrf(request), joke, await repository.listThemes(), state, { themes: joke.themes.map(theme => theme.name), newThemes: '' }));
  }));

  admin.post('/jokes/:id/themes', guard(async (request, reply) => {
    const body = record(request.body);
    const state = readListing(body);
    const id = resourceId(request);
    const joke = await repository.getJoke(id);
    if (!joke) return missingJoke(request, reply);
    try { await repository.setThemes(id, parseThemeInput(body)); }
    catch (error) {
      if (error instanceof ValidationError) return send(reply, renderThemeEditor(csrf(request), joke, await repository.listThemes(), state, readThemeDraft(body), error.message), 422);
      if (error instanceof ConflictError) return missingJoke(request, reply);
      throw error;
    }
    return reply.code(303).header('Location', listingUrl(state, '/admin/jokes', 'themes-saved')).send();
  }));

  admin.get('/jokes/:id/delete', guard(async (request, reply) => {
    const state = readListing(request.query);
    const joke = await repository.getJoke(resourceId(request));
    return joke ? send(reply, renderJokeDeletion(csrf(request), joke, state)) : missingJoke(request, reply);
  }));

  admin.post('/jokes/:id/delete', guard(async (request, reply) => {
    const body = record(request.body);
    const state = readListing(body);
    const id = resourceId(request);
    const joke = await repository.getJoke(id);
    if (!joke) return missingJoke(request, reply);
    if (body.confirmation !== 'delete') return send(reply, renderJokeDeletion(csrf(request), joke, state, 'Confirm deletion using the button below, or cancel.'), 422);
    if (!await repository.deleteJoke(id)) return missingJoke(request, reply);
    return reply.code(303).header('Location', listingUrl(state, '/admin/jokes', 'joke-deleted')).send();
  }));

  admin.get('/themes/:id/delete', guard(async (request, reply) => {
    const theme = await repository.getTheme(resourceId(request));
    return theme ? send(reply, renderThemeDeletion(csrf(request), theme)) : missingTheme(request, reply);
  }));

  admin.post('/themes/:id/delete', guard(async (request, reply) => {
    const body = record(request.body);
    const id = resourceId(request);
    const theme = await repository.getTheme(id);
    if (!theme) return missingTheme(request, reply);
    if (body.confirmation !== 'delete' || typeof body.expectedUsage !== 'string' || !/^\d{1,15}$/.test(body.expectedUsage)) {
      return send(reply, renderThemeDeletion(csrf(request), theme, 'Review the association count and confirm deletion using the button below, or cancel.'), 422);
    }
    try {
      if (!await repository.deleteTheme(id, Number(body.expectedUsage))) return missingTheme(request, reply);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const current = await repository.getTheme(id);
      return current ? send(reply, renderThemeDeletion(csrf(request), current, error.message), 409) : missingTheme(request, reply);
    }
    return reply.code(303).header('Location', '/admin/themes?notice=theme-deleted').send();
  }));
}
