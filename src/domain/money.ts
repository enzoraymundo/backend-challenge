import Decimal from 'decimal.js';

export class DomainError extends Error {}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency);
  }

  static from(amount: string, currency: string): Money {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new DomainError(`Valor inválido: ${amount}`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new DomainError(`Moeda inválida: ${currency}`);
    }
    return new Money(new Decimal(amount), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(`Moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}