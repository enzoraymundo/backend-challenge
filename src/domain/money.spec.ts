import { describe, expect, test } from 'bun:test'
import { Money } from './money'

describe('Money', () => {
  test('0.10 + 0.20 é exatamente 0.30', () => {
    const r = Money.from('0.10', 'BRL').add(Money.from('0.20', 'BRL'))
    expect(r.toString()).toBe('0.30')
  })

  test('subtrair pode dar negativo (quem decide se é permitido é a Wallet)', () => {
    const r = Money.from('10.00', 'BRL').subtract(Money.from('25.00', 'BRL'))
    expect(r.isNegative()).toBe(true)
  })

  test('rejeita mais de 2 casas decimais', () => {
    expect(() => Money.from('10.999', 'BRL')).toThrow()
  })

  test('rejeita valor negativo e texto', () => {
    expect(() => Money.from('-5.00', 'BRL')).toThrow()
    expect(() => Money.from('abc', 'BRL')).toThrow()
  })

  test('rejeita somar moedas diferentes', () => {
    expect(() => Money.from('1.00', 'BRL').add(Money.from('1.00', 'USD'))).toThrow()
  })
})