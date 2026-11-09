import { describe, expect, it } from 'vitest';
import { isJapanese, matchSimpleCommand, simpleCommandReply } from './simple-commands';

const names = ['Coo', 'クー'];

describe('matchSimpleCommand', () => {
  it.each([
    'Coo, come here!',
    'come here please',
    'Hey Coo come over here',
    'follow me',
    'クー、こっちに来て！',
    'クーちゃん こっちきて',
    'こっち来てください',
    'ここに来てくれる？',
    'おいで〜',
    'ついてきて',
  ])('"%s" is a come command', (text) => {
    expect(matchSimpleCommand(text, names)).toBe('come');
  });

  it.each(['Coo, stop!', 'stop moving', 'stay there', 'クー止まって', 'ストップ！', 'そこで止まってください'])('"%s" is a stop command', (text) => {
    expect(matchSimpleCommand(text, names)).toBe('stop');
  });

  it.each([
    'Coo',
    'can you come here tomorrow and explain x402?',
    'I will come here again',
    'こっちに来て、この商品について教えて',
    '起きて',
    "don't stop believing",
    'こんにちは',
    '',
  ])('"%s" is not a simple command', (text) => {
    expect(matchSimpleCommand(text, names)).toBeNull();
  });

  it('does not strip names inside other words', () => {
    expect(matchSimpleCommand('cool, come here', names)).toBeNull();
  });
});

describe('replies', () => {
  it('answers in Japanese to Japanese messages', () => {
    expect(isJapanese('こっちに来て')).toBe(true);
    expect(isJapanese('come here')).toBe(false);
    expect(simpleCommandReply('come', true)).toBe('今行きます！');
    expect(simpleCommandReply('stop', false)).toBe("Okay, I'll stay right here.");
  });
});
