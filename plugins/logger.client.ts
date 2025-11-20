import { defineNuxtPlugin } from '#imports'
import consola, { type ConsolaInstance } from 'consola'

const logger = consola.withTag('gmail-actions')

export default defineNuxtPlugin(() => ({
    provide: {
        logger,
    },
}))

declare module '#app' {
    interface NuxtApp {
        $logger: ConsolaInstance
    }
}

declare module '@vue/runtime-core' {
    interface ComponentCustomProperties {
        $logger: ConsolaInstance
    }
}
