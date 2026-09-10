import "server-only";

const MAX_EVENT_SIZE = 1024 * 1024;

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  let buffer = "";
  let data: string[] = [];
  let eventSize = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });

      while (true) {
        const separator = /[\r\n]/.exec(buffer);

        if (!separator) {
          if (buffer.length > MAX_EVENT_SIZE) {
            throw new Error("Invalid event stream");
          }

          break;
        }

        const index = separator.index;
        const character = buffer[index];

        // A CR at a chunk boundary may be followed by LF.
        if (character === "\r" && index === buffer.length - 1 && !done) {
          if (buffer.length > MAX_EVENT_SIZE) {
            throw new Error("Invalid event stream");
          }

          break;
        }

        if (index > MAX_EVENT_SIZE) {
          throw new Error("Invalid event stream");
        }

        const separatorLength =
          character === "\r" && buffer[index + 1] === "\n" ? 2 : 1;

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + separatorLength);

        if (line === "") {
          if (data.length > 0) {
            const event = data.join("\n");
            data = [];
            eventSize = 0;

            yield event;
          }

          continue;
        }

        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? "" : line.slice(colon + 1);

        if (fieldValue.startsWith(" ")) {
          fieldValue = fieldValue.slice(1);
        }

        if (field === "data") {
          eventSize += fieldValue.length + 1;

          if (eventSize > MAX_EVENT_SIZE) {
            throw new Error("Invalid event stream");
          }

          data.push(fieldValue);
        }
      }

      // An unterminated SSE event is not dispatched at EOF.
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
