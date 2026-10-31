import Decimal from 'decimal.js';

// erro enviado quando alguem manda um dado errado (valor ou moeda errada)
export class DomainError extends Error {}

//classe do dinheiro: valor + moeda
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  //cria um dinheiro com o valor 0
  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency)
  }

  //cria um dinheiro a partir de texto (ex: "25.00") e moeda (ex: "BRL")
  static from(amount: string, currency: string): Money {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new DomainError(`Valor inválido: ${amount}`)
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new DomainError(`Moeda inválida: ${currency}`)
    }
    return new Money(new Decimal(amount), currency)
  }

  //soma dois dinheiros e devolve um novo
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency)
  }

  //subtrai e devolve um novo dinheiro 
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency)
  }

  //responde: este valor é menor que o outro?
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other)
    return this.value.lessThan(other.value)
  }

  //responde: o valor é negativo?
  isNegative(): boolean {
    return this.value.isNegative()
  }
  
  //responde: esse valor é negativo?
  isZero(): boolean {
  return this.value.isZero();
  }

  //responde: valor e moeda são iguais aos do outro?
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value)
  }

  //devolve o valor como texto com 2 casas (ex.: "25.00")
  toString(): string {
    return this.value.toFixed(2)
  }

  //formato que a API devolve: { amount: "25.00", currency: "BRL" }
  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency }
  }

  //da erro se tentar misturar moedas diferentes (ex.: BRL com USD)
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(`Moedas diferentes: ${this.currency} e ${other.currency}`)
    }
  }
}