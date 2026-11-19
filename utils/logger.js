import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";

const stream = isDev
  ? pinoPretty({
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname",
  })
  : process.stdout;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization", "req.headers.cookie"],
    base: null,
  },
  stream
);

export const streamLog = {
  write: (message) => {
    logger.info(message.trim());
  },
};


