import {
  MlsMessage,
  MlsMessageProtocol,
  MlsPrivateMessage,
} from "ts-mls/message.js";
import { wireformats } from "ts-mls";

export type PrivateMessage = MlsMessageProtocol & MlsPrivateMessage;

/** Check if a MLSMessage is a private message */
export function isPrivateMessage(
  message: MlsMessage,
): message is PrivateMessage {
  return message.wireformat === wireformats.mls_private_message;
}
