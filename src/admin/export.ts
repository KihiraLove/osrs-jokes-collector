import type { FastifyInstance } from 'fastify';
import type { JokeRepository } from '../db/repository.ts';
import { ConflictError, ValidationError } from '../domain.ts';
import { serializeDecks } from '../exports/serialize.ts';
import { renderExport } from '../views/export.ts';
import { record, UUID } from './listing.ts';
import { csrfTokenForSession } from './store.ts';

function selectedIds(value: unknown): string[] {
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !UUID.test(id))) {
    throw new ValidationError('Choose valid decks from the list.');
  }
  const ids = [...new Set((values as string[]).map(id => id.toLowerCase()))];
  if (!ids.length) throw new ValidationError('Select at least one deck, or choose Download all decks.');
  return ids;
}

export function registerExport(admin: FastifyInstance, repository: JokeRepository): void {
  admin.get('/export', async (request, reply) => reply.type('text/html').send(
    renderExport(csrfTokenForSession(request.adminToken!), await repository.listDeckUsage()),
  ));

  admin.post('/export', async (request, reply) => {
    const body = record(request.body);
    let ids: string[] = [];
    try {
      if (body.scope !== 'selected' && body.scope !== 'all') throw new ValidationError('Choose Download selected decks or Download all decks.');
      if (body.scope === 'selected') ids = selectedIds(body.deckIds);
      // This single query owns both selection and contents, with no listing filters.
      const decks = await repository.readDecks(body.scope === 'all' ? undefined : ids);
      if (!decks.length) throw new ValidationError('There are no decks to export. Create a deck first.');
      const json = serializeDecks(decks);
      return reply.type('application/json; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="decks.json"').send(json);
    } catch (error) {
      if (!(error instanceof ValidationError || error instanceof ConflictError)) throw error;
      return reply.code(error instanceof ConflictError ? 409 : 422).type('text/html').send(
        renderExport(csrfTokenForSession(request.adminToken!), await repository.listDeckUsage(), ids, error.message),
      );
    }
  });
}
