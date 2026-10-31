import { Body, Controller, Post } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WalletsService) {}

  @Post()
  create(
    @Body()
    body: { playerId: string; initialBalance: { amount: string; currency: string } },
  ) {
    return this.service.create(body.playerId, body.initialBalance);
  }
}