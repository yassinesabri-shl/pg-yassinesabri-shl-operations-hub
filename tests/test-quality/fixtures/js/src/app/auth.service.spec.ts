import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  // ok: asserts the outcome, then verifies the http mock
  it('signs in and stores the token', () => {
    service.signIn('a', 'b').subscribe((token) => expect(token).toBe('t1'));
    http.expectOne('/api/sign-in').flush({ token: 't1' });
    http.verify();
  });

  // ok: an async Angular test with a named error
  it('rejects a bad password', waitForAsync(() => {
    expect(() => service.check('')).toThrow(InvalidPasswordError);
  }));

  // ruleid: shl-js-skipped
  it.skip('refreshes the token', () => {
    expect(service.refresh()).toBeTruthy();
  });

  // ruleid: shl-js-skipped
  xit('logs out', () => {
    expect(service.logOut()).toBe(true);
  });

  // ruleid: shl-js-skipped
  fit('focused on its own', () => {
    expect(service.ping()).toBe(1);
  });

  // ruleid: shl-js-skipped
  it.todo('handles expiry');

  it('tautologies', () => {
    // ruleid: shl-js-tautology
    expect(true).toBe(true);
    // ruleid: shl-js-tautology
    expect(service).toEqual(service);
  });

  it('any error', () => {
    // ruleid: shl-js-broad-error
    expect(() => service.check('')).toThrow();
    // ruleid: shl-js-broad-error
    expect(() => service.check('')).toThrow(Error);
  });

  // ruleid: shl-js-empty-test
  it('does nothing', () => {});

  // ruleid: shl-js-empty-test
  it('does nothing async', async () => {});

  // ruleid: shl-js-no-assertion
  it('runs but checks nothing', () => {
    service.signIn('a', 'b');
  });
});
