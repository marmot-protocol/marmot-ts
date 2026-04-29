import { readFileSync } from "node:fs";
import { Comment, CommentTag, Converter } from "typedoc";

const fileCategoryCache = new Map();

function categoryForFile(file) {
  if (fileCategoryCache.has(file)) return fileCategoryCache.get(file);

  let category = null;
  try {
    const src = readFileSync(file, "utf8");
    const firstBlock = src.match(/\/\*\*([\s\S]*?)\*\//);
    if (firstBlock && /@module\b/.test(firstBlock[1])) {
      const m = firstBlock[1].match(/@category\s+([^\r\n*]+)/);
      if (m) category = m[1].trim();
    }
  } catch {
    // unreadable source — leave uncategorized
  }

  fileCategoryCache.set(file, category);
  return category;
}

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const reflection of Object.values(context.project.reflections)) {
      const file = reflection.sources?.[0]?.fullFileName;
      if (!file) continue;
      if (reflection.comment?.getTag("@category")) continue;

      const category = categoryForFile(file);
      if (!category) continue;

      reflection.comment ??= new Comment();
      reflection.comment.blockTags.push(
        new CommentTag("@category", [{ kind: "text", text: category }]),
      );
    }
  });
}
