const { test } = require('node:test');
const assert = require('node:assert/strict');
const { yamlScalarInPath, sourceFromConfigCode, SOURCE_TYPE_LABELS } = require('../resources/nuclio-source-parser');

const GIT_WITH_ATTRIBUTES = `
apiVersion: "nuclio.io/v1"
kind: NuclioFunction
metadata:
  name: demo
spec:
  runtime: python:3.12
  build:
    codeEntryType: git
    path: https://github.com/my-org/my-repo.git
    codeEntryAttributes:
      branch: main
      tag: v1.2.3
      reference: a1b2c3d
      username: bea
      workDir: /nuclio-functions/myfunc
  triggers:
    mytrigger:
      kind: http
      maxWorkers: 4
`;

test('yamlScalarInPath reads a scalar at the exact parent path', () => {
    const text = GIT_WITH_ATTRIBUTES;
    assert.equal(yamlScalarInPath(text, ['spec', 'build'], 'codeEntryType'), 'git');
    assert.equal(yamlScalarInPath(text, ['spec', 'build'], 'path'), 'https://github.com/my-org/my-repo.git');
    assert.equal(yamlScalarInPath(text, ['spec', 'build', 'codeEntryAttributes'], 'branch'), 'main');
    assert.equal(yamlScalarInPath(text, ['spec', 'build', 'codeEntryAttributes'], 'workDir'), '/nuclio-functions/myfunc');
    assert.equal(yamlScalarInPath(text, ['spec', 'build'], 'branch'), '', 'branch lives under codeEntryAttributes');
    assert.equal(yamlScalarInPath(text, ['spec'], 'image'), '', 'image is not set');
});

test('yamlScalarInPath does not confuse a nested trigger kind with the build source', () => {
    const triggerKind = yamlScalarInPath(GIT_WITH_ATTRIBUTES, ['spec', 'build'], 'kind');
    assert.equal(triggerKind, '', 'kind is not a spec.build field');
});

test('sourceFromConfigCode reads git attributes from codeEntryAttributes', () => {
    assert.deepEqual(sourceFromConfigCode(GIT_WITH_ATTRIBUTES), {
        type: 'git',
        path: 'https://github.com/my-org/my-repo.git',
        branch: 'main',
        tag: 'v1.2.3',
        reference: 'a1b2c3d',
        username: 'bea',
        workDir: '/nuclio-functions/myfunc',
    });
});

test('sourceFromConfigCode normalizes the legacy github code entry type', () => {
    const text = `
spec:
  build:
    codeEntryType: github
    path: https://github.com/my-org/my-repo.git
`;
    assert.equal(sourceFromConfigCode(text).type, 'git');
});

test('sourceFromConfigCode returns an image source from spec.image', () => {
    const text = `
spec:
  image: mydockeruser/my-func:latest
`;
    assert.deepEqual(sourceFromConfigCode(text), {
        type: 'image',
        path: 'mydockeruser/my-func:latest',
    });
});

test('sourceFromConfigCode returns an archive source', () => {
    const text = `
spec:
  build:
    codeEntryType: archive
    path: https://example.com/my-function.zip
`;
    const result = sourceFromConfigCode(text);
    assert.equal(result.type, 'archive');
    assert.equal(result.path, 'https://example.com/my-function.zip');
});

test('sourceFromConfigCode treats a bare build path as advanced', () => {
    const text = `
spec:
  build:
    path: /some/local/path
`;
    assert.deepEqual(sourceFromConfigCode(text), { type: 'advanced' });
});

test('sourceFromConfigCode treats an unknown code entry type as advanced', () => {
    const text = `
spec:
  build:
    codeEntryType: s3
    path: bucket/path
`;
    assert.deepEqual(sourceFromConfigCode(text), { type: 'advanced' });
});

test('sourceFromConfigCode defaults to sourceCode when nothing is configured', () => {
    assert.deepEqual(sourceFromConfigCode(''), { type: 'sourceCode' });
    assert.deepEqual(sourceFromConfigCode('spec:\n  runtime: python:3.12\n'), { type: 'sourceCode' });
});

test('sourceFromConfigCode unquotes quoted scalars and strips trailing comments', () => {
    const text = `
spec:
  build:
    codeEntryType: "git"
    path: 'https://github.com/my-org/my-repo.git'  # trailing comment
    codeEntryAttributes:
      branch: "feature/x"
`;
    const result = sourceFromConfigCode(text);
    assert.equal(result.type, 'git');
    assert.equal(result.path, 'https://github.com/my-org/my-repo.git');
    assert.equal(result.branch, 'feature/x');
});

test('SOURCE_TYPE_LABELS covers the editor source selector options', () => {
    for (const type of ['sourceCode', 'image', 'git', 'archive', 'advanced']) {
        assert.ok(SOURCE_TYPE_LABELS[type], `missing label for ${type}`);
    }
});
