import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WageringService } from './wagering.service';
import type { SubmitBody } from './wagering.service';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly service: WageringService) {}

  // Devolve: 201 processada, 200 repetição, 422 rejeitada por regra de negócio
  @Post()
  async submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SubmitBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.submit(key, body);
    if (result.status === 'REJECTED') res.status(422);
    else res.status(result.idempotentReplay ? 200 : 201);
    return result;
  }
}