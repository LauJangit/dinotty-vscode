import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CancellationTokenLike,
  TerminalProfileController
} from '../src/terminalProfileController';

class TestCancellationToken implements CancellationTokenLike {
  isCancellationRequested = false;

  cancel(): void {
    this.isCancellationRequested = true;
  }
}

test('returns undefined without selecting when already cancelled', async () => {
  const token = new TestCancellationToken();
  token.cancel();
  let selectorCalls = 0;

  const controller = new TerminalProfileController({
    selectProfileId: () => {
      selectorCalls += 1;
      return 'profile-a';
    },
    createTerminalOptions: () => {
      throw new Error('options factory must not run');
    },
    createTerminalProfile: () => {
      throw new Error('profile factory must not run');
    }
  });

  assert.equal(await controller.provideTerminalProfile(token), undefined);
  assert.equal(selectorCalls, 0);
});

test('returns undefined when profile selection is cancelled', async () => {
  const token = new TestCancellationToken();
  let optionsFactoryCalls = 0;

  const controller = new TerminalProfileController({
    selectProfileId: () => undefined,
    createTerminalOptions: () => {
      optionsFactoryCalls += 1;
      throw new Error('options factory must not run');
    },
    createTerminalProfile: () => {
      throw new Error('profile factory must not run');
    }
  });

  assert.equal(await controller.provideTerminalProfile(token), undefined);
  assert.equal(optionsFactoryCalls, 0);
});

test('disposes prepared options when cancellation arrives during construction', async () => {
  const token = new TestCancellationToken();
  let disposeCalls = 0;
  let profileFactoryCalls = 0;

  const controller = new TerminalProfileController({
    selectProfileId: () => 'profile-a',
    createTerminalOptions: () => {
      token.cancel();
      return {
        options: { name: 'Dinotty: A' },
        dispose: () => {
          disposeCalls += 1;
        }
      };
    },
    createTerminalProfile: () => {
      profileFactoryCalls += 1;
      return { kind: 'profile' };
    }
  });

  assert.equal(await controller.provideTerminalProfile(token), undefined);
  assert.equal(disposeCalls, 1);
  assert.equal(profileFactoryCalls, 0);
});

test('returns only the profile without directly creating or showing a terminal', async () => {
  const token = new TestCancellationToken();
  let disposeCalls = 0;
  let createTerminalCalls = 0;
  let showCalls = 0;
  const options = {
    name: 'Dinotty: A',
    createTerminal: () => {
      createTerminalCalls += 1;
    },
    show: () => {
      showCalls += 1;
    }
  };
  const profile = { kind: 'terminal-profile', options };

  const controller = new TerminalProfileController({
    selectProfileId: () => 'profile-a',
    createTerminalOptions: (profileId) => {
      assert.equal(profileId, 'profile-a');
      return {
        options,
        dispose: () => {
          disposeCalls += 1;
        }
      };
    },
    createTerminalProfile: (createdOptions) => {
      assert.equal(createdOptions, options);
      return profile;
    }
  });

  assert.equal(await controller.provideTerminalProfile(token), profile);
  assert.equal(disposeCalls, 0);
  assert.equal(createTerminalCalls, 0);
  assert.equal(showCalls, 0);
});

test('disposes prepared options if cancellation is observed after profile creation', async () => {
  const token = new TestCancellationToken();
  let disposeCalls = 0;

  const controller = new TerminalProfileController({
    selectProfileId: () => 'profile-a',
    createTerminalOptions: () => ({
      options: { name: 'Dinotty: A' },
      dispose: () => {
        disposeCalls += 1;
      }
    }),
    createTerminalProfile: () => {
      token.cancel();
      return { kind: 'terminal-profile' };
    }
  });

  assert.equal(await controller.provideTerminalProfile(token), undefined);
  assert.equal(disposeCalls, 1);
});

test('disposes prepared options when the profile factory throws', async () => {
  const token = new TestCancellationToken();
  let disposeCalls = 0;
  const expected = new Error('profile construction failed');

  const controller = new TerminalProfileController({
    selectProfileId: () => 'profile-a',
    createTerminalOptions: () => ({
      options: { name: 'Dinotty: A' },
      dispose: () => {
        disposeCalls += 1;
      }
    }),
    createTerminalProfile: () => {
      throw expected;
    }
  });

  await assert.rejects(controller.provideTerminalProfile(token), expected);
  assert.equal(disposeCalls, 1);
});
