import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DatabaseError } from 'pg';

/**
 * Traduit les violations de contraintes PostgreSQL en réponses HTTP lisibles
 * au lieu d'une erreur 500. Le détail SQL n'est jamais renvoyé au client.
 */
export function httpErrorFor(err: DatabaseError): HttpException | null {
  switch (err.code) {
    case '23505':
      return new ConflictException('Cet élément existe déjà');
    case '23503':
      return new NotFoundException('Élément lié introuvable');
    case '23514':
    case '22003':
      return new UnprocessableEntityException('Valeur refusée par les règles de gestion');
    default:
      return null;
  }
}

@Catch(DatabaseError)
export class PgErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  catch(err: DatabaseError, host: ArgumentsHost) {
    super.catch(httpErrorFor(err) ?? err, host);
  }
}
