import { describe, expect, test } from 'vitest';

import { BlockList } from './block-list';

describe('net.BlockList', () => {
  test('matches addresses, ranges and subnets of either family, as Node does', () => {
    const list = new BlockList();
    list.addAddress('123.123.123.123');
    list.addRange('10.0.0.1', '10.0.0.10');
    list.addSubnet('8592:757c:efae:4e45::', 64, 'ipv6');
    list.addSubnet({ address: '192.168.0.0', family: 'ipv4' }, 16);

    expect(list.check('123.123.123.123')).toBe(true);
    expect(list.check('10.0.0.3')).toBe(true);
    expect(list.check('10.0.0.11')).toBe(false);
    expect(list.check('222.111.111.222')).toBe(false);
    expect(list.check('8592:757c:efae:4e45::f', 'IPv6')).toBe(true);
    expect(list.check('8592:757c:efae:4e46::f', 'ipv6')).toBe(false);
    expect(list.check('::ffff:7b7b:7b7b', 'ipv6')).toBe(true);
    expect(list.check('192.168.200.1')).toBe(true);
    expect(list.rules).toEqual([
      'Subnet: IPv4 192.168.0.0/16',
      'Subnet: IPv6 8592:757c:efae:4e45::/64',
      'Range: IPv4 10.0.0.1-10.0.0.10',
      'Address: IPv4 123.123.123.123'
    ]);
    expect(BlockList.isBlockList(list)).toBe(true);
  });

  test('rejects what Node rejects', () => {
    const list = new BlockList();
    expect(() => list.addAddress('1.2.3')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ADDRESS' }));
    expect(() => list.addSubnet('10.0.0.0', 33)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => list.addRange('10.0.0.9', '10.0.0.1')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => list.addAddress('10.0.0.1', 'ipv5')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('check() answers false for what is no address of the family, and rejects only what is no string', () => {
    const list = new BlockList();
    list.addAddress('1.2.3.4');
    list.addAddress('fe80::1', 'ipv6');

    for (const [address, family] of [['1.2.3'], ['not an ip'], [''], ['1.2.3.4', 'ipv5'], ['1.2.3.4', 'ipv6'], ['fe80::1%eth0']]) {
      expect(list.check(address!, family)).toBe(false);
    }
    expect(list.check('1.2.3.4', 'IPV4')).toBe(true);
    // Node reads the zone of a scoped IPv6 address and leaves it out.
    expect(list.check('fe80::1%eth0', 'ipv6')).toBe(true);
    expect(() => list.check(42 as unknown as string)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => list.check('1.2.3.4', null as unknown as string)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
  });
});
