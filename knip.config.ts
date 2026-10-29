import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: ["src/test-external/**/*.test.ts"],
  ignoreDependencies: ["chai", "@types/chai", "@types/mocha"],
});
