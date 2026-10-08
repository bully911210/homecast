import { generateFixtures } from './generate.ts';

export default async function setup(): Promise<void> {
  await generateFixtures();
}
