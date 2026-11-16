/**
 * Browser module declaration for CSS imported as text and injected by the
 * plugin's own style tag.
 */
declare module '*.css' {
  const text: string
  export default text
}

/**
 * Slot contributed by this plugin.
 *
 * `dsh-client-ui-model-selection` owns `conversation.input.model` and declares
 * its option list here; declaring it again lets this plugin register a row group
 * inside that menu without depending on the model-selection package's types.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.model.options': {
      kind: 'list'
      scope: 'session'
      owner: {
        locked: boolean
        dismiss: () => void
        reportFailure: (message: string) => void
      }
    }
  }
}

