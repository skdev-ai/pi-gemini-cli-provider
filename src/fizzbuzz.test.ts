import { fizzBuzz } from './fizzbuzz';

describe('fizzBuzz', () => {
  test('should return correct array for n = 5', () => {
    expect(fizzBuzz(5)).toEqual(["1", "2", "Fizz", "4", "Buzz"]);
  });

  test('should return correct array for n = 3', () => {
    expect(fizzBuzz(3)).toEqual(["1", "2", "Fizz"]);
  });

  test('should return correct array for n = 15', () => {
    expect(fizzBuzz(15)).toEqual([
      "1", "2", "Fizz", "4", "Buzz",
      "Fizz", "7", "8", "Fizz", "Buzz",
      "11", "Fizz", "13", "14", "FizzBuzz"
    ]);
  });

  test('should return an empty array for n = 0', () => {
    expect(fizzBuzz(0)).toEqual([]);
  });

  test('should return an array with "1" for n = 1', () => {
    expect(fizzBuzz(1)).toEqual(["1"]);
  });
});
