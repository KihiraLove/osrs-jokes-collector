import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JokeRepository } from '../db/repository.ts';
import { ConflictError, ValidationError } from '../domain.ts';
import type { DeckTarget } from '../domain.ts';
import { renderDeckDeletion, renderDeckRename, renderDecks } from '../views/decks.ts';
import { renderModerationNotice } from '../views/moderation.ts';
import { listingUrl, readListing, record, UUID } from './listing.ts';
import { showJokes } from './moderation.ts';
import { csrfTokenForSession, secretDigest } from './store.ts';

const csrf = (request: FastifyRequest) => csrfTokenForSession(request.adminToken!);
const session = (request: FastifyRequest) => secretDigest(request.adminToken!);

function ids(value: unknown, maximum = 500): string[] {
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length > maximum || values.some(id => typeof id !== 'string' || !UUID.test(id))) throw new ValidationError(`Choose at most ${maximum} valid joke IDs.`);
  return [...new Set((values as string[]).map(id => id.toLowerCase()))];
}
function id(request: FastifyRequest): string {
  const value = record(request.params).id;
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('This deck link is invalid.');
  return value;
}
function failure(error: unknown): { status: number; message: string } | null {
  if (error instanceof ValidationError) return { status: 422, message: error.message };
  if (error instanceof ConflictError) return { status: 409, message: error.message };
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'decks_normalized_name_key') return { status: 409, message: 'A deck with this name already exists. Choose that deck or use another name.' };
  return null;
}

export function registerDecks(admin: FastifyInstance, repository: JokeRepository): void {
  const missing = (request: FastifyRequest) => renderModerationNotice(csrf(request), 'This deck no longer exists. Return to Decks to see the current list.');
  admin.get('/selection', async request => repository.selection(session(request)));
  admin.post('/selection', async (request, reply) => {
    const body = record(request.body);
    const json = request.headers.accept?.includes('application/json');
    const state = readListing(body);
    try {
      const page = body.action === 'page' || body.action === 'all' ? ids(body.pageIds, 100) : [];
      const selected = body.action === 'all' ? page : body.action === 'page' ? ids(body.selectedIds, 100) : [];
      if (typeof body.action !== 'string' || !['page', 'all', 'clear', 'prune'].includes(body.action)) throw new ValidationError('Choose a selection action.');
      const result = await repository.changeSelection(session(request), body.action === 'all' ? 'page' : body.action as 'page' | 'clear' | 'prune', page, selected);
      return json ? reply.send(result) : reply.code(303).header('Location', listingUrl(state, '/admin/jokes', 'selection-updated')).send();
    } catch (error) {
      const problem = failure(error);
      if (!problem) throw error;
      return json ? reply.code(problem.status).send({ error: problem.message }) : showJokes(request, reply, repository, state, { message: problem.message, error: true }, problem.status);
    }
  });

  admin.post('/assign', async (request, reply) => {
    const body = record(request.body);
    const state = readListing(body);
    const draft = { target: typeof body.target === 'string' ? body.target : '', name: typeof body.name === 'string' ? body.name : '' };
    try {
      let target: DeckTarget;
      if (body.target === 'new') {
        if (typeof body.name !== 'string') throw new ValidationError('Enter a name for the new deck.');
        target = { kind: 'new', name: body.name };
      } else if (body.target === 'none') target = { kind: 'none' };
      else if (typeof body.target === 'string' && UUID.test(body.target)) target = { kind: 'existing', id: body.target };
      else throw new ValidationError('Choose a target deck, Create a new deck or Remove from deck.');
      const result = await repository.assignSelection(session(request), ids(body.expectedIds), target);
      const location = listingUrl(state, '/admin/jokes', target.kind === 'none' ? 'unassigned' : target.kind === 'new' ? 'created-assigned' : 'assigned');
      return reply.code(303).header('Location', `${location}&count=${result.count}&changed=${result.changed}&moved=${result.moved}`).send();
    } catch (error) {
      const problem = failure(error);
      if (!problem) throw error;
      return showJokes(request, reply, repository, state, { draft, message: problem.message, error: true }, problem.status);
    }
  });

  admin.get('/decks', async (request, reply) => {
    const value = record(request.query).notice;
    const message = value === 'created' ? 'The deck was created.' : value === 'renamed' ? 'The deck name was saved. Its export ID is unchanged.' : value === 'deleted' ? 'The deck was deleted. Its jokes are unassigned; their text and themes were preserved.' : '';
    return reply.type('text/html').send(renderDecks(csrf(request), await repository.listDeckUsage(), '', message));
  });
  admin.post('/decks', async (request, reply) => {
    const name = record(request.body).name;
    try {
      if (typeof name !== 'string') throw new ValidationError('Enter a deck name.');
      await repository.createDeck(name);
      return reply.code(303).header('Location', '/admin/decks?notice=created').send();
    } catch (error) {
      const problem = failure(error);
      if (!problem) throw error;
      return reply.code(problem.status).type('text/html').send(renderDecks(csrf(request), await repository.listDeckUsage(), typeof name === 'string' ? name : '', problem.message, true));
    }
  });
  for (const action of ['rename', 'delete'] as const) {
    admin.get(`/decks/:id/${action}`, async (request, reply) => {
      const deck = await repository.getDeck(id(request));
      return deck ? reply.type('text/html').send(action === 'rename' ? renderDeckRename(csrf(request), deck) : renderDeckDeletion(csrf(request), deck)) : reply.code(404).type('text/html').send(missing(request));
    });
    admin.post(`/decks/:id/${action}`, async (request, reply) => {
      const deckId = id(request);
      const deck = await repository.getDeck(deckId);
      if (!deck) return reply.code(404).type('text/html').send(missing(request));
      const body = record(request.body);
      try {
        if (action === 'rename') {
          if (typeof body.name !== 'string') throw new ValidationError('Enter a deck name.');
          await repository.renameDeck(deckId, body.name);
        } else {
          if (body.confirmation !== 'delete' || typeof body.expectedUsage !== 'string' || !/^\d{1,15}$/.test(body.expectedUsage)) throw new ValidationError('Review the joke count and confirm deletion, or cancel.');
          if (!await repository.deleteDeck(deckId, Number(body.expectedUsage))) return reply.code(404).type('text/html').send(missing(request));
        }
        return reply.code(303).header('Location', `/admin/decks?notice=${action === 'rename' ? 'renamed' : 'deleted'}`).send();
      } catch (error) {
        const problem = failure(error);
        if (!problem) throw error;
        const current = await repository.getDeck(deckId);
        if (!current) return reply.code(404).type('text/html').send(missing(request));
        return reply.code(problem.status).type('text/html').send(action === 'rename' ? renderDeckRename(csrf(request), current, typeof body.name === 'string' ? body.name : '', problem.message) : renderDeckDeletion(csrf(request), current, problem.message));
      }
    });
  }
}
