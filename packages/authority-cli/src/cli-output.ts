export function printResult<T>(result: T, jsonOutput: boolean, format: (value: T) => string): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(format(result));
}
