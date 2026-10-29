import { Body, Controller, HttpCode, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { importRequestSchema, type ImportRequest } from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { badRequest } from '../common/api-error';
import { ZodPipe } from '../common/zod.pipe';
import { ImportsService, type ImportFile, type ImportPreview } from './imports.service';

/** Largest file accepted (nginx allows 25 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const upload = FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

function required(file: ImportFile | undefined): ImportFile {
  if (!file) throw badRequest('import.noFile');
  return file;
}

/**
 * Excel import of a month's sheet (AGENTS.md: Excel import), part of Payroll. Every request
 * sends the file with the month and, once the user has seen it, the column mapping.
 * Owners, admins and accountants import hours; adding workers is for owners and admins.
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** What both steps would do with the file, and every problem row. Writes nothing. */
  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(upload)
  preview(
    @CompanyAuth() auth: CompanyAuthContext,
    @UploadedFile() file: ImportFile | undefined,
    @Body(new ZodPipe(importRequestSchema)) body: ImportRequest,
  ): Promise<ImportPreview> {
    return this.imports.preview(auth, required(file), body);
  }

  @Post('workers')
  @Roles('OWNER', 'ADMIN')
  @UseInterceptors(upload)
  commitWorkers(
    @CompanyAuth() auth: CompanyAuthContext,
    @UploadedFile() file: ImportFile | undefined,
    @Body(new ZodPipe(importRequestSchema)) body: ImportRequest,
  ): Promise<{ created: number }> {
    return this.imports.commitWorkers(auth, required(file), body);
  }

  @Post('hours')
  @UseInterceptors(upload)
  commitHours(
    @CompanyAuth() auth: CompanyAuthContext,
    @UploadedFile() file: ImportFile | undefined,
    @Body(new ZodPipe(importRequestSchema)) body: ImportRequest,
  ): Promise<{ importId: string; workers: number }> {
    return this.imports.commitHours(auth, required(file), body);
  }
}
