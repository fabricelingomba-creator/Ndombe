import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { Env, loadEnv } from './config/env';

export function configureApp(app: INestApplication, env: Env) {
  const express = app as NestExpressApplication;
  // Nécessaire derrière Cloudflare / l'ingress pour lire le bon nom d'hôte et la bonne IP.
  express.set('trust proxy', env.TRUST_PROXY_HOPS);
  express.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));
  configureApp(app, env);
  await app.listen(env.PORT);
  console.log(`API Elongo sur le port ${env.PORT}`);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
