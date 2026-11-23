import { memoryDatabase } from "../memory.js";
import { runDatabaseConformance } from "./conformance.js";

runDatabaseConformance("memory", async () => memoryDatabase());
