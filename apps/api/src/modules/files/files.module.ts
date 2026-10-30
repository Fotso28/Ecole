import {
  BadRequestException,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Global,
  HttpException,
  Injectable,
  Module,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { fileCheckMessage } from '@ecole/shared';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { Public } from '../../common/decorators';
import { env } from '../../config/env';
import { FilesService } from './files.service';
import { contentDisposition, createStorage, FILE_STORAGE } from './storage.provider';

// Sans `dest` ni `storage`, multer garde le fichier en mémoire.
const MulterFile = FileInterceptor('file', {
  // Un octet de marge : le dépassement est signalé par le contrôle du service, en français.
  limits: { fileSize: env().FILE_MAX_BYTES + 1, files: 1, fields: 20 },
});

/**
 * Lecture du champ `file` d'un formulaire multipart, en mémoire, après le contrôle des droits
 * (les intercepteurs s'exécutent après le garde d'authentification).
 */
@Injectable()
export class FileUpload implements NestInterceptor {
  private readonly inner = new MulterFile();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.inner.intercept(context, next);
    } catch (e) {
      if (e instanceof PayloadTooLargeException)
        throw new PayloadTooLargeException(fileCheckMessage('too_large', env().FILE_MAX_BYTES));
      if (e instanceof HttpException)
        throw new BadRequestException(
          'Envoi du fichier impossible : un seul fichier, champ « file »',
        );
      throw e;
    }
  }
}

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Lien signé de courte durée, délivré par l'API après contrôle des droits. */
  @Public()
  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response) {
    const { file, content } = await this.files.openSigned(token);
    res.setHeader('content-type', file.mimeType);
    res.setHeader('content-length', String(content.length));
    res.setHeader('content-disposition', contentDisposition(file.originalName));
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(content);
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    { provide: FILE_STORAGE, useFactory: () => createStorage(env()) },
    FilesService,
    FileUpload,
  ],
  exports: [FilesService, FILE_STORAGE, FileUpload],
})
export class FilesModule {}
