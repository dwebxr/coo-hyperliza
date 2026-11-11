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
    // An agent named Top: its name goes as a word, and stays where it is part of "stop"
    expect(matchSimpleCommand('Top, stop!', ['Top'])).toBe('stop');
    expect(matchSimpleCommand('stop', ['Top'])).toBe('stop');
    expect(matchSimpleCommand('stcooop', names)).toBeNull();
  });

  it('takes no message longer than 60 characters for a command, whatever is left of it without punctuation', () => {
    expect(matchSimpleCommand(`come here${'!'.repeat(51)}`, names)).toBe('come');
    expect(matchSimpleCommand(`come here${'!'.repeat(52)}`, names)).toBeNull();
  });
});

describe('replies', () => {
  it('answers in Japanese to Japanese messages, in English otherwise', () => {
    expect(isJapanese('こっちに来て')).toBe(true);
    expect(isJapanese('come here')).toBe(false);
    expect(simpleCommandReply('come', true)).toBe('今行きます！');
    expect(simpleCommandReply('stop', true)).toBe('はい、ここで止まりますね。');
    expect(simpleCommandReply('come', false)).toBe('On my way!');
    expect(simpleCommandReply('stop', false)).toBe("Okay, I'll stay right here.");
  });
});
