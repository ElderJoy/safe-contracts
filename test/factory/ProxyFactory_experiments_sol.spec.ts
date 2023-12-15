import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";
import { Contract } from "ethers";
import { getFactory, getSingleton1, getSingleton2, getSafeProxyRuntimeCode } from "../utils/setup";
import { AddressZero } from "@ethersproject/constants";
import { calculateProxyAddress } from "../../src/utils/proxies";

describe("ProxyFactory experiments", () => {
    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const signers = await ethers.getSigners();
        const [operator, user1, user2] = signers;
        return {
            factory: await getFactory(),
            singleton1: await getSingleton1(),
            singleton2: await getSingleton2(),
            operator,
            user1,
            user2        
        };
    });

    describe("Singleton upgrade experiment with Singletons in sol", () => {
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
            expect(await proxy_s2.makeCallToGetCallerAddress(proxy2.getAddress())).to.be.eq(proxyAddress1);
            expect(await proxy_s2.makeCallToGetCallerAddress2(proxy2.getAddress())).to.be.eq(proxyAddress1);
        });
    });
});
