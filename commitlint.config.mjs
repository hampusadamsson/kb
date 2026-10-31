export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // the repo uses free-form areas as scopes, e.g. feat(web): live tab
    "scope-empty": [1, "never"],
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "body-max-line-length": [1, "always", 140],
  },
};
