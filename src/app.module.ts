import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WalletsModule } from './wallets/wallets.module';
import { WageringModule } from './wagering/wagering.module'
@Module({
  imports: [MikroOrmModule.forRoot(config), WalletsModule, WageringModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
