import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { httpErrorFor } from './pg-error.filter';

function pgError(code: string) {
  const err = new DatabaseError('détail SQL interne', 0, 'error');
  err.code = code;
  return err;
}

describe('Erreurs PostgreSQL → HTTP', () => {
  it('traduit les violations de contraintes', () => {
    expect(httpErrorFor(pgError('23505'))).toBeInstanceOf(ConflictException);
    expect(httpErrorFor(pgError('23503'))).toBeInstanceOf(NotFoundException);
    expect(httpErrorFor(pgError('23514'))).toBeInstanceOf(UnprocessableEntityException);
  });

  it('ne renvoie jamais le message SQL au client', () => {
    expect(httpErrorFor(pgError('23505'))!.message).not.toContain('SQL');
  });

  it('laisse les autres erreurs devenir des 500', () => {
    expect(httpErrorFor(pgError('42P01'))).toBeNull();
  });
});
