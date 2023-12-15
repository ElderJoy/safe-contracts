import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";
import { Contract } from "ethers";
import { deployContract, getFactory, getMock, getSafeWithOwners, getSafeProxyRuntimeCode } from "../utils/setup";
import { AddressZero } from "@ethersproject/constants";
import { calculateChainSpecificProxyAddress, calculateProxyAddress, calculateProxyAddressWithCallback } from "../../src/utils/proxies";
import { chainId } from "../utils/encoding";

describe("ProxyFactory experiments", () => {
    const SINGLETON_SOURCE1 = `
    contract Singleton1 {
        address _singleton;
        address public owner;
        bool public isInitialized;

        constructor() payable {
            owner = msg.sender;
        }

        function init(address new_owner) public {
            require(!isInitialized, "Is initialized");
            owner = new_owner;
            isInitialized = true;
        }

        function upgradeSingleton(address newImplementation) public {
            require(isInitialized, "Not initialized");
            require(msg.sender == owner, "Not owner");
            _singleton = newImplementation;
        }

        // To be clear, SafeProxy catch masterCopy() call and return _singleton address
        // so, this implementation is only used in direct call to Singleton1 contract
        function masterCopy() public pure returns (address) {
            return address(0);
        }

        // Makes call to another contract and return caller address
        function makeCallToGetCallerAddress(Singleton1 callee) public view returns (address) {
            return callee.getCallerAddress();
        }

        // Abstract implementation of getCallerAddress
        function makeCallToGetCallerAddress2(address callee) public view returns (address) {
            (bool success, bytes memory result) = callee.staticcall(abi.encodeWithSignature("getCallerAddress()"));
            require(success, "Failed to call");
            return abi.decode(result, (address));
        }

        function getCallerAddress() public view returns (address) {
            return msg.sender;
        }
    }`;

    const SINGLETON_SOURCE2 = `
    contract Singleton2 {
        // Variables from Singleton1 should stay on their place
        address _singleton;
        address public owner;
        bool public isInitialized;

        // New variables can be added after old ones
        uint256 public value;

        function masterCopy() public pure returns (address) {
            return address(0);
        }

        function setValue(uint256 _value) public {
            value = _value;
        }

        function getValue() public view returns (uint256) {
            return value;
        }

        // Abstract implementation of getCallerAddress
        function makeCallToGetCallerAddress2(address callee) public view returns (address) {
            (bool success, bytes memory result) = callee.staticcall(abi.encodeWithSignature("getCallerAddress()"));
            require(success, "Failed to call");
            return abi.decode(result, (address));
        }

        function getCallerAddress() public view returns (address) {
            return msg.sender;
        }        
    }`;


    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const signers = await ethers.getSigners();
        const [operator, user1, user2] = signers;
        // Singletons deployed from operator
        const singleton1 = await deployContract(operator, SINGLETON_SOURCE1);
        const singleton2 = await deployContract(operator, SINGLETON_SOURCE2);
        return {
            factory: await getFactory(),
            singleton1,
            singleton2,
            operator,
            user1,
            user2        
        };
    });

    describe("Singleton upgrade experiment", () => {
        const saltNonce = 42;

        it("proxy initialization set user as owner", async () => {
            const { factory, singleton1, operator, user1 } = await setupTests();

            // Singleton1 owner is operator
            expect(await singleton1.owner()).to.be.eq(operator.address);

            // Deploy proxy for Singleton1 with user1 as owner
            const singletonAddress1 = await singleton1.getAddress();
            const initCode = singleton1.interface.encodeFunctionData("init", [user1.address]);
            const proxyAddress1 = await calculateProxyAddress(factory, singletonAddress1, initCode, saltNonce);
            await expect(factory.createProxyWithNonce(singletonAddress1, initCode, saltNonce))
                .to.emit(factory, "ProxyCreation")
                .withArgs(proxyAddress1, singletonAddress1);
            const proxy1 = singleton1.attach(proxyAddress1) as Contract;

            // Check that proxy1 is initialized and user1 is owner
            expect(await proxy1.isInitialized()).to.be.eq(true);
            expect(await proxy1.owner()).to.be.eq(user1.address);

            // Check that masterCopy of Singleton1 is zero
            expect(await singleton1.masterCopy()).to.be.eq(AddressZero);

            // Check that masterCopy of proxy1 is Singleton1
            expect(await proxy1.masterCopy()).to.be.eq(singletonAddress1);

            // Check that proxy1 is a SafeProxy
            expect(await hre.ethers.provider.getCode(proxyAddress1)).to.be.eq(await getSafeProxyRuntimeCode());
        });

        it("two deployed proxies to the same singleton are different", async () => {
            const { factory, singleton1, user1, user2 } = await setupTests();
            const singletonAddress1 = await singleton1.getAddress();

            // Deploy proxy for Singleton1 with user1 as owner
            const initCode1 = singleton1.interface.encodeFunctionData("init", [user1.address]);
            const proxyAddress1 = await calculateProxyAddress(factory, singletonAddress1, initCode1, saltNonce);
            await expect(factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce))
                .to.emit(factory, "ProxyCreation")
                .withArgs(proxyAddress1, singletonAddress1);
            const proxy1 = singleton1.attach(proxyAddress1) as Contract;

            // Deploy proxy for Singleton1 with user2 as owner (saltNonce can be the same,
            // addresses would be different because of different initialization parameters - user addresses)
            const initCode2 = singleton1.interface.encodeFunctionData("init", [user2.address]);
            const proxyAddress2 = await calculateProxyAddress(factory, singletonAddress1, initCode2, saltNonce);
            expect(proxyAddress2).to.not.be.eq(proxyAddress1);

            await expect(factory.createProxyWithNonce(singletonAddress1, initCode2, saltNonce))
                .to.emit(factory, "ProxyCreation")
                .withArgs(proxyAddress2, singletonAddress1);
            const proxy2 = singleton1.attach(proxyAddress2) as Contract;

            // Check that proxies are initialized and have different owners
            expect(await proxy1.isInitialized()).to.be.eq(true);
            expect(await proxy1.owner()).to.be.eq(user1.address);
            expect(await proxy2.isInitialized()).to.be.eq(true);
            expect(await proxy2.owner()).to.be.eq(user2.address);
        });
        
        it("singleton can be upgraded by owner - proxy stay the same", async () => {
            const { factory, singleton1, singleton2, operator, user1 } = await setupTests();
            const singletonAddress1 = await singleton1.getAddress();
            const singletonAddress2 = await singleton2.getAddress();

            // Deploy proxy for Singleton1 with user1 as owner
            const initCode = singleton1.interface.encodeFunctionData("init", [user1.address]);
            const proxyAddress1 = await calculateProxyAddress(factory, singletonAddress1, initCode, saltNonce);
            await expect(factory.createProxyWithNonce(singletonAddress1, initCode, saltNonce))
                .to.emit(factory, "ProxyCreation")
                .withArgs(proxyAddress1, singletonAddress1);

            const proxy_s1 = singleton1.attach(proxyAddress1) as Contract;
            expect(await proxy_s1.owner()).to.be.eq(user1.address);
            expect(await proxy_s1.isInitialized()).to.be.eq(true);
            expect(await proxy_s1.masterCopy()).to.be.eq(singletonAddress1);

            
            // Check that not owner can't upgrade singleton (even operator)
            await expect(proxy_s1.connect(operator).upgradeSingleton(singletonAddress2))
                .to.be.revertedWith("Not owner");

            // Check that owner can upgrade singleton
            await proxy_s1.connect(user1).upgradeSingleton(singleton2.getAddress());

            // Require new proxy handler, that act as Singleton2
            const proxy_s2 = singleton2.attach(proxyAddress1) as Contract;


            // Check that proxy2 is still initialized and user1 is owner
            expect(await proxy_s2.owner()).to.be.eq(user1.address);
            expect(await proxy_s2.isInitialized()).to.be.eq(true);

            // Check that masterCopy of proxy2 is Singleton2
            expect(await proxy_s2.masterCopy()).to.be.eq(singletonAddress2);

            // Check that it have new functions and variables
            expect(await proxy_s2.getValue()).to.be.eq(0);
            await proxy_s2.setValue(42);
            expect(await proxy_s2.getValue()).to.be.eq(42);
        });

        it("caller address should be a proxy address", async () => {
            const { factory, singleton1, user1 } = await setupTests();

            const singletonAddress1 = await singleton1.getAddress();
            const initCode1 = singleton1.interface.encodeFunctionData("init", [user1.address]);

            // Deploy proxy for Singleton1 with user1 as owner and saltNonce1 to calculate unique proxy address
            const saltNonce1 = 41;
            const proxyAddress1 = await calculateProxyAddress(factory, singletonAddress1, initCode1, saltNonce1);
            await factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce1);
            const proxy1 = singleton1.attach(proxyAddress1) as Contract;

            // Check that deploy with same saltNonce1 will fail
            await expect(factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce1)).to.be.revertedWith("Create2 call failed");

            // Deploy proxy for Singleton1 with user1 as owner and saltNonce2 to calculate other unique proxy address
            const saltNonce2 = 42;
            const proxyAddress2 = await calculateProxyAddress(factory, singletonAddress1, initCode1, saltNonce2);
            await factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce2);
            const proxy2 = singleton1.attach(proxyAddress2) as Contract;

            // Check that when proxy makes call to another contract, caller address is a proxy address
            expect(await proxy1.makeCallToGetCallerAddress(proxy2.getAddress())).to.be.eq(proxyAddress1);

            // Check caller address with another function
            expect(await proxy1.makeCallToGetCallerAddress2(proxy2.getAddress())).to.be.eq(proxyAddress1);
        });

        it("after upgrade singleton caller address should stay the same", async () => {
            const { factory, singleton1, singleton2, user1 } = await setupTests();

            const singletonAddress1 = await singleton1.getAddress();
            const singletonAddress2 = await singleton2.getAddress();

            const initCode1 = singleton1.interface.encodeFunctionData("init", [user1.address]);

            // Deploy proxy for Singleton1 with user1 as owner and saltNonce1 to calculate unique proxy address
            const saltNonce1 = 41;
            const proxyAddress1 = await calculateProxyAddress(factory, singletonAddress1, initCode1, saltNonce1);
            await factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce1);
            const proxy_s1 = singleton1.attach(proxyAddress1) as Contract;

            // Deploy proxy for Singleton1 with user1 as owner and saltNonce2 to calculate other unique proxy address
            const saltNonce2 = 42;
            const proxyAddress2 = await calculateProxyAddress(factory, singletonAddress1, initCode1, saltNonce2);
            await factory.createProxyWithNonce(singletonAddress1, initCode1, saltNonce2);
            const proxy2 = singleton1.attach(proxyAddress2) as Contract;

            // Upgrade Singleton1 to Singleton2
            await proxy_s1.connect(user1).upgradeSingleton(singletonAddress2);
            const proxy_s2 = singleton2.attach(proxyAddress1) as Contract;

            // Check that caller address is still the same
            expect(await proxy_s2.makeCallToGetCallerAddress2(proxy2.getAddress())).to.be.eq(proxyAddress1);
        });
    });
});
