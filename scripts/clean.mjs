/** Remove generated package outputs. */
import { rm } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const packages = join(process.cwd(), 'packages')
for (const name of await readdir(packages)) {
  await rm(join(packages, name, 'lib'), { recursive: true, force: true })
}
process.stdout.write('removed package lib/ outputs\n')
